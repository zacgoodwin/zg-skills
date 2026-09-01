// Gate tests for lib/findings.ts -- the heart of the suite.
//
// Quote resolution is where hallucinated citations die, so it gets the most
// cases. Severity and confidence get table tests because their constants are
// guesses until the eval calibrates them: a table makes a re-tune a one-line
// change with visible consequences rather than a spelunk.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle, type Bundle } from "../lib/bundle.ts";
import {
  bandFor,
  confidenceBase,
  seatBase,
  seatPartName,
  CONFIDENCE_APPENDIX_FLOOR,
  CONFIDENCE_DETERMINISTIC,
  fingerprintOf,
  normalizeWhitespace,
  placementOf,
  refutationOutcome,
  refutationPriority,
  resolveAndMerge,
  resolveQuote,
  mostSpecificKind,
  sameFindingAs,
  siteKeys,
  scoreConfidence,
  scoreSeverity,
  seatVendor,
  type Finding,
  type RawFinding,
  type ResolvedSide,
} from "../lib/findings.ts";

let scratch: string;
let n = 0;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "find-test-"));
});
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

function bundleOf(docs: Record<string, string>): Bundle {
  const dir = join(scratch, `b${n++}`);
  mkdirSync(dir, { recursive: true });
  const names = Object.keys(docs);
  for (const name of names) writeFileSync(join(dir, name), docs[name]);
  return loadBundle(names, dir, dir);
}

function sidesFrom(bundle: Bundle, quotes: string[]): ResolvedSide[] {
  return quotes.map((q, i) => ({ label: `side ${i}`, quote: q, instances: resolveQuote(bundle, q) }));
}

describe("resolveQuote", () => {
  test("finds every occurrence, which is how one issue yields all its instances", () => {
    const b = bundleOf({
      "a.md": "Tokens last 7 days.\nfiller\nTokens last 7 days.\n",
      "b.md": "Tokens last 7 days.\n",
    });
    const got = resolveQuote(b, "Tokens last 7 days.");
    expect(got).toHaveLength(3);
    expect(got.map((i) => `${i.docId}:${i.line}`)).toEqual(["D1:1", "D1:3", "D2:1"]);
    expect(got.every((i) => i.quality === "exact")).toBe(true);
  });

  test("a paraphrase resolves nowhere -- the anti-hallucination gate", () => {
    const b = bundleOf({ "a.md": "Tokens expire after seven days.\n" });
    expect(resolveQuote(b, "Tokens expire after a week.")).toEqual([]);
  });

  test("a substring of a real line still grounds", () => {
    const b = bundleOf({ "a.md": "The timeout is 30s by default.\n" });
    const got = resolveQuote(b, "timeout is 30s");
    expect(got).toHaveLength(1);
    expect(got[0].quality).toBe("exact");
  });

  test("whitespace-normalized fallback is marked weaker, not silently equal", () => {
    const b = bundleOf({ "a.md": "The   timeout   is 30s.\n" });
    const got = resolveQuote(b, "The timeout is 30s.");
    expect(got).toHaveLength(1);
    expect(got[0].quality).toBe("normalized");
  });

  test("a quote spanning a line wrap resolves to its starting line", () => {
    const b = bundleOf({ "a.md": "Tokens expire\nafter 24 hours.\n" });
    const got = resolveQuote(b, "Tokens expire after 24 hours.");
    expect(got).toHaveLength(1);
    expect(got[0].line).toBe(1);
    expect(got[0].quality).toBe("normalized");
  });

  test("exact matches win outright -- a normalized pass never dilutes them", () => {
    const b = bundleOf({ "a.md": "value is 5\n", "b.md": "value   is   5\n" });
    const got = resolveQuote(b, "value is 5");
    expect(got).toHaveLength(1);
    expect(got[0].docId).toBe("D1");
  });

  test("an empty quote is a caller bug, not an empty result", () => {
    const b = bundleOf({ "a.md": "x\n" });
    expect(() => resolveQuote(b, "   ")).toThrow(/empty quote/);
  });

  test("normalizeWhitespace collapses runs and trims, nothing else", () => {
    expect(normalizeWhitespace("  a \n b  ")).toBe("a b");
    expect(normalizeWhitespace("Case KEPT")).toBe("Case KEPT");
  });
});

describe("severity rubric", () => {
  // (modality x detectability) + blast + hazard, banded high>=8 medium>=4.
  const cases: { name: string; docs: Record<string, string>; quotes: string[]; want: number; band: string }[] = [
    {
      name: "directive conflict across documents with a hazard word",
      docs: {
        "a.md": "You must run migrations before deploying to production.\n",
        "b.md": "You must never run migrations before deploying to production.\n",
      },
      quotes: ["You must run migrations before deploying to production.", "You must never run migrations before deploying to production."],
      want: 3 * 3 + 1 + 2,
      band: "high",
    },
    {
      name: "directive conflict across documents, no hazard",
      docs: { "a.md": "You must indent with tabs.\n", "b.md": "You must indent with spaces.\n" },
      quotes: ["You must indent with tabs.", "You must indent with spaces."],
      want: 3 * 3 + 1 + 0,
      band: "high",
    },
    {
      name: "descriptive trivia across documents",
      docs: { "a.md": "The project began in 2019.\n", "b.md": "The project began in 2020.\n" },
      quotes: ["The project began in 2019.", "The project began in 2020."],
      want: 1 * 3 + 1 + 0,
      band: "medium",
    },
    {
      name: "directive conflict inside one section is visible, so it ranks low",
      docs: { "a.md": "# Style\nYou must use tabs.\nYou must use spaces.\n" },
      quotes: ["You must use tabs.", "You must use spaces."],
      want: 3 * 1 + 1 + 0,
      band: "medium",
    },
    // The two cases below both land on 7, one point under the high cutoff.
    // CALIBRATION WATCH: a mixed-modality cross-document conflict ("the guide
    // says set it to 5, the reference says it is 10") is among the most common
    // real defects in developer docs, and it currently reads medium. If the
    // phase-10 eval shows these dominating the true positives, the high cutoff
    // moves from 8 to 7 -- one constant, and this table shows the blast radius.
    {
      name: "same document, different sections",
      docs: { "a.md": "# One\nYou must use tabs.\n# Two\nYou must use spaces.\n" },
      quotes: ["You must use tabs.", "You must use spaces."],
      want: 3 * 2 + 1 + 0,
      band: "medium",
    },
    {
      name: "mixed modality: one side commands, one describes",
      docs: { "a.md": "You must set the limit to 5.\n", "b.md": "The limit is 10.\n" },
      quotes: ["You must set the limit to 5.", "The limit is 10."],
      want: 2 * 3 + 1 + 0,
      band: "medium",
    },
    {
      name: "a quickstart site lifts blast even with few instances",
      docs: { "a.md": "# Quickstart\nThe port is 8080.\n", "b.md": "The port is 3000.\n" },
      quotes: ["The port is 8080.", "The port is 3000."],
      want: 1 * 3 + 2 + 0,
      band: "medium",
    },
    {
      name: "four or more instances lift blast",
      docs: {
        "a.md": "The limit is 5.\nfiller\nThe limit is 5.\n",
        "b.md": "The limit is 10.\nfiller\nThe limit is 10.\n",
      },
      quotes: ["The limit is 5.", "The limit is 10."],
      want: 1 * 3 + 2 + 0,
      band: "medium",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const b = bundleOf(c.docs);
      const sev = scoreSeverity(b, sidesFrom(b, c.quotes));
      expect(sev.score).toBe(c.want);
      expect(sev.band).toBe(c.band as any);
    });
  }

  test("bandFor honours the documented cutoffs", () => {
    expect(bandFor(8)).toBe("high");
    expect(bandFor(7)).toBe("medium");
    expect(bandFor(4)).toBe("medium");
    expect(bandFor(3)).toBe("low");
  });

  test("an override moves exactly one band and records where it came from", () => {
    const b = bundleOf({ "a.md": "The count is 1.\n", "b.md": "The count is 2.\n" });
    const sides = sidesFrom(b, ["The count is 1.", "The count is 2."]);
    const up = scoreSeverity(b, sides, { direction: "up", reason: "bricks the cluster" });
    expect(up.band).toBe("high");
    expect(up.override).toMatchObject({ direction: "up", from: "medium" });
    // The mechanical score is preserved so a re-tune can see what it did.
    expect(up.score).toBe(4);
  });

  test("an override cannot escape the band range", () => {
    const b = bundleOf({ "a.md": "# S\nThe count is 1.\nThe count is 2.\n" });
    const sides = sidesFrom(b, ["The count is 1.", "The count is 2."]);
    const down = scoreSeverity(b, sides, { direction: "down", reason: "cosmetic" });
    expect(down.band).toBe("low");
    const downAgain = scoreSeverity(b, sides, { direction: "down", reason: "still cosmetic" });
    expect(downAgain.band).toBe("low");
  });
});

describe("confidence", () => {
  test("seatVendor separates the CLIs from Claude seats", () => {
    expect(seatVendor("shard-2")).toBe("claude");
    expect(seatVendor("term-cluster")).toBe("claude");
    expect(seatVendor("codex")).toBe("codex");
    expect(seatVendor("codex:o3")).toBe("codex");
    expect(seatVendor("agy")).toBe("agy");
    expect(seatVendor("antigravity")).toBe("agy");
  });

  const baseCases: { seats: string[]; exact: boolean; want: number }[] = [
    { seats: ["shard-1"], exact: true, want: 36 },
    { seats: ["shard-1"], exact: false, want: 30 },
    { seats: ["shard-1", "shard-2"], exact: true, want: 48 },
    { seats: ["shard-1", "shard-2", "shard-3"], exact: true, want: 60 },
    // The per-seat bonus caps at three seats; a fourth adds nothing.
    { seats: ["shard-1", "shard-2", "shard-3", "shard-4"], exact: true, want: 60 },
    { seats: ["shard-1", "codex"], exact: true, want: 58 },
    { seats: ["shard-1", "shard-2", "codex"], exact: true, want: 70 },
    // Duplicate seat ids are one seat.
    { seats: ["shard-1", "shard-1"], exact: true, want: 36 },
  ];

  for (const c of baseCases) {
    test(`base ${c.seats.join("+")}${c.exact ? " exact" : " fuzzy"} = ${c.want}`, () => {
      expect(confidenceBase(c.seats, c.exact)).toBe(c.want);
    });
  }

  // A CLI seat whose brief exceeded the provider's input cap runs as parts. They
  // are one reader, and crediting them as several would manufacture exactly the
  // agreement the score is supposed to measure.
  test("parts of one split seat are one seat", () => {
    expect(seatBase(seatPartName("cli-codex", 0, 3))).toBe("cli-codex");
    expect(seatBase(seatPartName("cli-codex", 0, 1))).toBe("cli-codex");
    expect(seatPartName("cli-codex", 1, 3)).toBe("cli-codex~part-2of3");
    // Untouched for a seat that never split, including one with a model suffix.
    expect(seatBase("cli-agy-gemini-3")).toBe("cli-agy-gemini-3");
    expect(seatBase("shard-1")).toBe("shard-1");
    // A model may legally contain "-part-1of2"; the suffix uses "~", which
    // CLI_MODEL_RE forbids, so a real model name can never be mistaken for one.
    expect(seatBase("cli-codex-part-1of2")).toBe("cli-codex-part-1of2");
    expect(seatBase(seatPartName("cli-codex-part-1of2", 0, 2))).toBe("cli-codex-part-1of2");

    // prepare sizes a split against the widest suffix it could ever generate.
    // That is only sound if the widest really is the longest string.
    const widest = seatPartName("cli-codex", 89, 90).length;
    for (let total = 2; total <= 90; total++) {
      for (const i of [0, total - 1]) expect(seatPartName("cli-codex", i, total).length).toBeLessThanOrEqual(widest);
    }

    const parts = [0, 1, 2].map((i) => seatBase(seatPartName("cli-codex", i, 3)));
    expect(confidenceBase(parts, true)).toBe(confidenceBase(["cli-codex"], true));
  });

  test("refutationOutcome buckets every combination", () => {
    expect(refutationOutcome(0, 0)).toBe("unrefuted");
    expect(refutationOutcome(3, 0)).toBe("all-upheld");
    expect(refutationOutcome(2, 0)).toBe("all-upheld");
    // One lone upheld verdict is not a quorum.
    expect(refutationOutcome(1, 0)).toBe("majority-upheld");
    expect(refutationOutcome(2, 1)).toBe("majority-upheld");
    expect(refutationOutcome(1, 1)).toBe("split");
    expect(refutationOutcome(1, 2)).toBe("majority-refuted");
    expect(refutationOutcome(0, 3)).toBe("all-refuted");
  });

  test("the worked examples from the plan hold", () => {
    // One Claude seat, clean quotes, three refuters upheld.
    expect(scoreConfidence(["shard-1"], true, { upheld: 3, refuted: 0, confused: 0 }).score).toBe(61);
    // Three seats spanning vendors, clean, three upheld.
    expect(scoreConfidence(["shard-1", "shard-2", "codex"], true, { upheld: 3, refuted: 0, confused: 0 }).score).toBe(95);
    // Same, unrefuted.
    const un = scoreConfidence(["shard-1", "shard-2", "codex"], true);
    expect(un.score).toBe(70);
    expect(un.outcome).toBe("unrefuted");
    // One seat, fuzzy quote, split refuters.
    expect(scoreConfidence(["shard-1"], false, { upheld: 1, refuted: 1, confused: 0 }).score).toBe(15);
  });

  test("the score clamps rather than overflowing", () => {
    expect(scoreConfidence(["a", "b", "codex"], true, { upheld: 5, refuted: 0, confused: 0 }).score).toBeLessThanOrEqual(100);
    expect(scoreConfidence(["a"], false, { upheld: 0, refuted: 3, confused: 0 }).score).toBe(0);
  });

  test("CONFUSED counts as neither side", () => {
    const c = scoreConfidence(["a"], true, { upheld: 2, refuted: 0, confused: 1 });
    expect(c.outcome).toBe("all-upheld");
    expect(c.confused).toBe(1);
  });
});

describe("placement and refutation priority", () => {
  function fake(severity: number, base: number, outcome: Parameters<typeof placementOf>[0]["confidence"]["outcome"], score: number): Finding {
    return {
      id: "F-01",
      kind: "contradiction",
      title: "t",
      summary: "s",
      sides: [],
      options: [],
      severity: { score: severity, band: bandFor(severity), factors: { modality: 1, detectability: 1, blast: 0, hazard: 0 } },
      confidence: { base, delta: 0, score, outcome, upheld: 0, refuted: 0, confused: 0 },
      seats: [],
      fingerprint: "x",
    };
  }

  test("a refuted finding goes to its appendix regardless of score", () => {
    expect(placementOf(fake(10, 70, "all-refuted", 10))).toBe("refuted");
    expect(placementOf(fake(10, 70, "majority-refuted", 45))).toBe("refuted");
  });

  test("below the floor goes to the low-confidence appendix, never deleted", () => {
    expect(placementOf(fake(5, 30, "split", CONFIDENCE_APPENDIX_FLOOR - 1))).toBe("low-confidence");
    expect(placementOf(fake(5, 30, "split", CONFIDENCE_APPENDIX_FLOOR))).toBe("main");
  });

  test("priority favours high stakes and thin evidence", () => {
    const highStakesThin = fake(11, 36, "unrefuted", 36);
    const highStakesAgreed = fake(11, 70, "unrefuted", 70);
    const lowStakesThin = fake(3, 36, "unrefuted", 36);
    expect(refutationPriority(highStakesThin)).toBeGreaterThan(refutationPriority(highStakesAgreed));
    expect(refutationPriority(highStakesThin)).toBeGreaterThan(refutationPriority(lowStakesThin));
  });
});

describe("fingerprint", () => {
  test("is stable across line moves and whitespace, since quotes are the identity", () => {
    const a = fingerprintOf("contradiction", ["Tokens last 7 days.", "Tokens last 1 day."]);
    const b = fingerprintOf("contradiction", ["Tokens  last 1 day.", "tokens last 7 days."]);
    expect(a).toBe(b);
  });

  test("differs by kind and by content", () => {
    expect(fingerprintOf("contradiction", ["x"])).not.toBe(fingerprintOf("structure", ["x"]));
    expect(fingerprintOf("contradiction", ["x"])).not.toBe(fingerprintOf("contradiction", ["y"]));
  });
});

describe("resolveAndMerge", () => {
  const raw = (over: Partial<RawFinding> = {}): RawFinding => ({
    kind: "contradiction",
    title: "Token lifetime disagrees",
    summary: "two values",
    sides: [
      { label: "A", quote: "Tokens last 7 days." },
      { label: "B", quote: "Tokens last 1 day." },
    ],
    options: [
      { label: "align on 7", edits: [{ quote: "Tokens last 1 day." }], consequence: "1 edit" },
      { label: "align on 1", edits: [{ quote: "Tokens last 7 days." }], consequence: "1 edit" },
    ],
    ...over,
  });

  const docs = { "a.md": "Tokens last 7 days.\n", "b.md": "Tokens last 1 day.\n" };

  test("resolves, assigns ids, and labels options A/B in order", () => {
    const b = bundleOf(docs);
    const { findings, unverifiable } = resolveAndMerge(b, [{ seat: "shard-1", findings: [raw()] }]);
    expect(unverifiable).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("F-01");
    expect(findings[0].options.map((o) => o.id)).toEqual(["A", "B"]);
    expect(findings[0].sides[0].instances[0]).toMatchObject({ docId: "D1", line: 1 });
  });

  test("two seats finding the same thing merge and raise confidence", () => {
    const b = bundleOf(docs);
    const { findings } = resolveAndMerge(b, [
      { seat: "shard-1", findings: [raw()] },
      { seat: "codex", findings: [raw()] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].seats.sort()).toEqual(["codex", "shard-1"]);
    expect(findings[0].confidence.base).toBe(58); // 30 + 12 + 10 multi-vendor + 6 clean
  });

  test("seats quoting DIFFERENT spans of the same conflict still merge", () => {
    // The eval's headline bug. Three seats each quoted a slightly different
    // slice of the same two sentences, so nothing merged: one defect was
    // reported three times, and each copy claimed the confidence of a
    // single-seat finding when three seats had independently agreed.
    const b = bundleOf({
      "a.md": "Tokens last 7 days. Raise it for long sessions.\n",
      "b.md": "Tokens last 1 day.\n",
    });
    const short = raw({
      sides: [
        { label: "A", quote: "Tokens last 7 days." },
        { label: "B", quote: "Tokens last 1 day." },
      ],
      options: [
        { label: "align on 7", edits: [{ quote: "Tokens last 1 day." }], consequence: "1 edit" },
        { label: "align on 1", edits: [{ quote: "Tokens last 7 days." }], consequence: "1 edit" },
      ],
    });
    const long = raw({
      sides: [
        { label: "A", quote: "Tokens last 7 days. Raise it for long sessions." },
        { label: "B", quote: "Tokens last 1 day." },
      ],
      options: [
        { label: "align on 7", edits: [{ quote: "Tokens last 1 day." }], consequence: "1 edit" },
        { label: "align on 1", edits: [{ quote: "Tokens last 7 days." }], consequence: "1 edit" },
      ],
    });
    const { findings } = resolveAndMerge(b, [
      { seat: "shard-1", findings: [short] },
      { seat: "term-cluster", findings: [long] },
      { seat: "numeric-cluster", findings: [short] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].seats.sort()).toEqual(["numeric-cluster", "shard-1", "term-cluster"]);
    expect(findings[0].confidence.base).toBe(60); // three seats, one vendor, clean quotes
  });

  test("seats disagreeing about the KIND still merge, keeping the more specific label", () => {
    // Also from the eval: one seat filed the API-key collision as
    // `term-collision` and another as `contradiction`. Requiring the labels to
    // match left the same defect in the plan twice, with its confidence split.
    const b = bundleOf(docs);
    const { findings } = resolveAndMerge(b, [
      { seat: "reduce", findings: [raw({ kind: "contradiction" })] },
      { seat: "term-cluster", findings: [raw({ kind: "term-collision" })] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("term-collision");
    expect(findings[0].seats.sort()).toEqual(["reduce", "term-cluster"]);
  });

  test("the merged finding's fingerprint matches the kind it shipped with", () => {
    const b = bundleOf(docs);
    const { findings } = resolveAndMerge(b, [
      { seat: "s1", findings: [raw({ kind: "contradiction" })] },
      { seat: "s2", findings: [raw({ kind: "numeric-conflict" })] },
    ]);
    const f = findings[0];
    expect(f.kind).toBe("numeric-conflict");
    expect(f.fingerprint).toBe(fingerprintOf("numeric-conflict", f.sides.map((s) => s.quote)));
  });

  test("a structure-lens finding is marked deterministic and scored as a fact", () => {
    // The eval's second bug: three refuters killed a verifiable duplicate
    // heading, evidently on the grounds that it did not matter. A finding
    // computed from the document graph is not a claim, so it never goes to
    // refuters and its confidence says so.
    const b = bundleOf({ "a.md": "## Errors\ntext\n## Errors\n" });
    const f: RawFinding = {
      kind: "structure",
      title: "Duplicate heading",
      summary: "s",
      sides: [
        { label: "one", quote: "## Errors", atLine: 1 },
        { label: "two", quote: "## Errors", atLine: 3 },
      ],
      options: [
        { label: "rename", edits: [{ quote: "## Errors", atLine: 3 }], consequence: "1 edit" },
        { label: "merge", edits: [{ quote: "## Errors", atLine: 1 }], consequence: "1 edit" },
      ],
    };
    const { findings } = resolveAndMerge(b, [{ seat: "structure-lens", findings: [f] }]);
    expect(findings[0].deterministic).toBe(true);
    expect(findings[0].confidence.score).toBe(CONFIDENCE_DETERMINISTIC);
    expect(placementOf(findings[0])).toBe("main");
  });

  test("a model agreeing with the structure lens keeps the finding a fact", () => {
    const b = bundleOf({ "a.md": "## Errors\ntext\n## Errors\n" });
    const f = (): RawFinding => ({
      kind: "structure",
      title: "Duplicate heading",
      summary: "s",
      sides: [
        { label: "one", quote: "## Errors", atLine: 1 },
        { label: "two", quote: "## Errors", atLine: 3 },
      ],
      options: [
        { label: "rename", edits: [{ quote: "## Errors", atLine: 3 }], consequence: "1 edit" },
        { label: "merge", edits: [{ quote: "## Errors", atLine: 1 }], consequence: "1 edit" },
      ],
    });
    const { findings } = resolveAndMerge(b, [
      { seat: "structure-lens", findings: [f()] },
      { seat: "shard-1", findings: [f()] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].deterministic).toBe(true);
    expect(findings[0].confidence.score).toBe(CONFIDENCE_DETERMINISTIC);
  });

  test("a model-found finding is never marked deterministic", () => {
    const b = bundleOf(docs);
    const { findings } = resolveAndMerge(b, [{ seat: "shard-1", findings: [raw()] }]);
    expect(findings[0].deterministic).toBeUndefined();
  });

  test("mostSpecificKind prefers a real label over the catch-all", () => {
    expect(mostSpecificKind("contradiction", "term-collision")).toBe("term-collision");
    expect(mostSpecificKind("numeric-conflict", "contradiction")).toBe("numeric-conflict");
    expect(mostSpecificKind("structure", "term-collision")).toBe("structure");
    expect(mostSpecificKind("contradiction", "contradiction")).toBe("contradiction");
  });

  test("two findings sharing only one site of several do not merge", () => {
    // A shared quote is not a shared conflict: a contradiction is identified by
    // the PAIR of places that disagree.
    const b = bundleOf({
      "a.md": "Tokens last 7 days.\n",
      "b.md": "Tokens last 1 day.\n",
      "c.md": "Tokens last 30 days.\n",
    });
    const mk = (other: string) =>
      raw({
        sides: [
          { label: "A", quote: "Tokens last 7 days." },
          { label: "B", quote: other },
        ],
        options: [
          { label: "x", edits: [{ quote: other }], consequence: "1 edit" },
          { label: "y", edits: [{ quote: "Tokens last 7 days." }], consequence: "1 edit" },
        ],
      });
    const { findings } = resolveAndMerge(b, [
      { seat: "s1", findings: [mk("Tokens last 1 day.")] },
      { seat: "s2", findings: [mk("Tokens last 30 days.")] },
    ]);
    expect(findings).toHaveLength(2);
  });

  test("a merge keeps the variant that cites more places when option counts tie", () => {
    const b = bundleOf({
      "a.md": "Tokens last 7 days.\nThe session ends with them.\n",
      "b.md": "Tokens last 1 day.\n",
    });
    const opts = [
      { label: "x", edits: [{ quote: "Tokens last 1 day." }], consequence: "1" },
      { label: "y", edits: [{ quote: "Tokens last 7 days." }], consequence: "1" },
    ];
    const thin = raw({
      sides: [
        { label: "A", quote: "Tokens last 7 days." },
        { label: "B", quote: "Tokens last 1 day." },
      ],
      options: opts,
    });
    const thick = raw({
      sides: [
        { label: "A", quote: "Tokens last 7 days." },
        { label: "A2", quote: "The session ends with them." },
        { label: "B", quote: "Tokens last 1 day." },
      ],
      options: opts,
    });
    const { findings } = resolveAndMerge(b, [{ seat: "s1", findings: [thin] }, { seat: "s2", findings: [thick] }]);
    expect(findings).toHaveLength(1);
    expect(siteKeys(findings[0]).size).toBe(3);
  });

  test("sameFindingAs is the rule the merge uses, and it is checkable on its own", () => {
    const b = bundleOf({ "a.md": "one line here\nsecond line here\n", "b.md": "third line here\n" });
    const side = (q: string) => ({ label: q, quote: q, instances: resolveQuote(b, q) });
    const A = { kind: "contradiction" as const, sides: [side("one line here"), side("third line here")] };
    const B = { kind: "contradiction" as const, sides: [side("one line here"), side("third line here")] };
    const C = { kind: "contradiction" as const, sides: [side("one line here"), side("second line here")] };
    expect(sameFindingAs(A, B)).toBe(true);
    expect(sameFindingAs(A, C)).toBe(false); // shares one site of two
    // Kind is not part of identity; the sites are.
    expect(sameFindingAs(A, { ...B, kind: "numeric-conflict" as const })).toBe(true);
    // Two one-site findings at the same place are the same finding...
    const one = { kind: "structure" as const, sides: [side("one line here")] };
    expect(sameFindingAs(one, { kind: "structure" as const, sides: [side("one line here")] })).toBe(true);
    // ...but a one-site finding is never swallowed by a two-sided one that
    // merely quotes the same line as one of its sides.
    expect(sameFindingAs(one, A)).toBe(false);
  });

  test("merge order does not change the result", () => {
    const b = bundleOf(docs);
    const a = resolveAndMerge(b, [{ seat: "s1", findings: [raw()] }, { seat: "s2", findings: [raw()] }]);
    const c = resolveAndMerge(b, [{ seat: "s2", findings: [raw()] }, { seat: "s1", findings: [raw()] }]);
    expect(a.findings.map((f) => f.title)).toEqual(c.findings.map((f) => f.title));
    expect(a.findings[0].confidence.base).toBe(c.findings[0].confidence.base);
  });

  test("the merged variant keeps whichever offers the human more ways out", () => {
    const b = bundleOf(docs);
    const three = raw({
      options: [
        { label: "align on 7", edits: [{ quote: "Tokens last 1 day." }], consequence: "1 edit" },
        { label: "align on 1", edits: [{ quote: "Tokens last 7 days." }], consequence: "1 edit" },
        { label: "state both with scope", edits: [{ quote: "Tokens last 7 days." }], consequence: "1 edit" },
      ],
    });
    const { findings } = resolveAndMerge(b, [
      { seat: "shard-1", findings: [raw()] },
      { seat: "shard-2", findings: [three] },
    ]);
    expect(findings[0].options).toHaveLength(3);
  });

  test("an ungrounded quote becomes an unverifiable entry, not a finding", () => {
    const b = bundleOf(docs);
    const bad = raw({ sides: [{ label: "A", quote: "Tokens last a fortnight." }] });
    const { findings, unverifiable } = resolveAndMerge(b, [{ seat: "shard-1", findings: [bad] }]);
    expect(findings).toEqual([]);
    expect(unverifiable[0].reason).toMatch(/quote not found/);
    expect(unverifiable[0].seat).toBe("shard-1");
  });

  test("an option with no edits is rejected -- that case is 'change nothing'", () => {
    const b = bundleOf(docs);
    const bad = raw({ options: [{ label: "nothing", edits: [], consequence: "" }] });
    const { unverifiable } = resolveAndMerge(b, [{ seat: "shard-1", findings: [bad] }]);
    expect(unverifiable[0].reason).toMatch(/declares no edits/);
  });

  test("an option edit quote must ground too", () => {
    const b = bundleOf(docs);
    const bad = raw({ options: [{ label: "x", edits: [{ quote: "not in any doc" }], consequence: "" }] });
    const { unverifiable } = resolveAndMerge(b, [{ seat: "shard-1", findings: [bad] }]);
    expect(unverifiable[0].reason).toMatch(/edit quote not found/);
  });

  test("a declined fingerprint is suppressed, so a decision is not re-litigated", () => {
    const b = bundleOf(docs);
    const fp = fingerprintOf("contradiction", ["Tokens last 7 days.", "Tokens last 1 day."]);
    const { findings } = resolveAndMerge(b, [{ seat: "shard-1", findings: [raw()] }], new Set([fp]));
    expect(findings).toEqual([]);
  });

  test("worst first: severity outranks confidence in the ordering", () => {
    const b = bundleOf({
      "a.md": "You must delete the production database.\n",
      "b.md": "You must never delete the production database.\n",
      "c.md": "The colour is blue.\n",
      "d.md": "The colour is green.\n",
    });
    const severe = raw({
      title: "severe",
      sides: [
        { label: "A", quote: "You must delete the production database." },
        { label: "B", quote: "You must never delete the production database." },
      ],
      options: [{ label: "x", edits: [{ quote: "You must delete the production database." }], consequence: "" }],
    });
    const mild = raw({
      title: "mild",
      sides: [
        { label: "A", quote: "The colour is blue." },
        { label: "B", quote: "The colour is green." },
      ],
      options: [{ label: "x", edits: [{ quote: "The colour is blue." }], consequence: "" }],
    });
    const { findings } = resolveAndMerge(b, [
      { seat: "s1", findings: [mild] },
      { seat: "s2", findings: [mild] },
      { seat: "s3", findings: [severe] },
    ]);
    expect(findings[0].title).toBe("severe");
    expect(findings[0].id).toBe("F-01");
  });

  test("atLine narrows a repeated quote to one occurrence", () => {
    const b = bundleOf({ "a.md": "## Errors\nx\n## Other\n## Errors\n" });
    const dupe: RawFinding = {
      kind: "structure",
      title: "Duplicate heading",
      summary: "s",
      sides: [
        { label: "first", quote: "## Errors", atLine: 1 },
        { label: "second", quote: "## Errors", atLine: 4 },
      ],
      options: [
        { label: "rename the later one", edits: [{ quote: "## Errors", atLine: 4 }], consequence: "1 edit" },
        { label: "merge", edits: [{ quote: "## Errors", atLine: 1 }, { quote: "## Errors", atLine: 4 }], consequence: "2 edits" },
      ],
    };
    const { findings } = resolveAndMerge(b, [{ seat: "structure-lens", findings: [dupe] }]);
    expect(findings[0].sides[0].instances.map((i) => i.line)).toEqual([1]);
    expect(findings[0].sides[1].instances.map((i) => i.line)).toEqual([4]);
    // An option's declared edit count is what the apply gate checks, so it must
    // match what the option says.
    expect(findings[0].options[0].editSites.map((i) => i.line)).toEqual([4]);
    expect(findings[0].options[1].editSites.map((i) => i.line)).toEqual([1, 4]);
  });

  test("without atLine, a repeated quote still cites every occurrence", () => {
    const b = bundleOf({ "a.md": "## Errors\nx\n## Errors\n" });
    const f: RawFinding = {
      kind: "structure",
      title: "t",
      summary: "s",
      sides: [{ label: "both", quote: "## Errors" }],
      options: [{ label: "fix", edits: [{ quote: "## Errors" }], consequence: "" }],
    };
    const { findings } = resolveAndMerge(b, [{ seat: "s", findings: [f] }]);
    expect(findings[0].sides[0].instances.map((i) => i.line)).toEqual([1, 3]);
  });

  test("a pin that misses is reported, not silently widened", () => {
    const b = bundleOf({ "a.md": "## Errors\n" });
    const f: RawFinding = {
      kind: "structure",
      title: "t",
      summary: "s",
      sides: [{ label: "x", quote: "## Errors", atLine: 9 }],
      options: [{ label: "fix", edits: [{ quote: "## Errors" }], consequence: "" }],
    };
    const { findings, unverifiable } = resolveAndMerge(b, [{ seat: "s", findings: [f] }]);
    expect(findings).toEqual([]);
    expect(unverifiable[0].reason).toMatch(/pinned to line 9/);
  });

  test("one option reaching the same site twice counts it once", () => {
    const b = bundleOf({ "a.md": "value is 5\n" });
    const f: RawFinding = {
      kind: "numeric-conflict",
      title: "t",
      summary: "s",
      sides: [{ label: "x", quote: "value is 5" }],
      options: [
        { label: "fix", edits: [{ quote: "value is 5" }, { quote: "value is 5" }], consequence: "1 edit" },
        { label: "other", edits: [{ quote: "value is 5" }], consequence: "1 edit" },
      ],
    };
    const { findings } = resolveAndMerge(b, [{ seat: "s", findings: [f] }]);
    expect(findings[0].options[0].editSites).toHaveLength(1);
  });

  test("a malformed kind is reported rather than crashing the merge", () => {
    const b = bundleOf(docs);
    const bad = { ...raw(), kind: "nonsense" } as unknown as RawFinding;
    const { findings, unverifiable } = resolveAndMerge(b, [{ seat: "s", findings: [bad, raw()] }]);
    expect(unverifiable[0].reason).toMatch(/unknown kind/);
    expect(findings).toHaveLength(1);
  });
});

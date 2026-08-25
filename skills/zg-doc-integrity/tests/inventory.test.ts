// Gate tests for lib/inventory.ts: the deterministic pre-pass that does the
// cross-document work. What matters most here is what these inventories do NOT
// emit -- agreement, synonyms nobody defined, and stale changelog numbers all
// have to stay out, or every downstream agent drowns in candidates.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle, type Bundle } from "../lib/bundle.ts";
import {
  buildDirectiveInventory,
  buildLinkInventory,
  buildNumericInventory,
  buildTermInventory,
  directiveSubject,
  durationToMs,
  normalizeTerm,
  numericSubject,
  splitSentences,
} from "../lib/inventory.ts";

let scratch: string;
let n = 0;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "inv-test-"));
});
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

// Each bundle gets its own directory so tests never see each other's files.
function bundleOf(docs: Record<string, string>): Bundle {
  const dir = join(scratch, `b${n++}`);
  mkdirSync(dir, { recursive: true });
  const names = Object.keys(docs);
  for (const name of names) writeFileSync(join(dir, name), docs[name]);
  return loadBundle(names, dir, dir);
}

describe("normalizeTerm", () => {
  test("collapses the four ways one concept gets spelled differently", () => {
    const want = "api key";
    expect(normalizeTerm("API key")).toBe(want);
    expect(normalizeTerm("api-key")).toBe(want);
    expect(normalizeTerm("api_key")).toBe(want);
    expect(normalizeTerm("apiKey")).toBe(want);
    expect(normalizeTerm("API Keys")).toBe(want);
  });

  test("plural folding handles the common English endings", () => {
    expect(normalizeTerm("policies")).toBe("policy");
    expect(normalizeTerm("batches")).toBe("batch");
    expect(normalizeTerm("tokens")).toBe("token");
    // A word genuinely ending in double-s is not a plural.
    expect(normalizeTerm("access")).toBe("access");
  });
});

describe("term inventory", () => {
  test("surfaces a term two places take the trouble to define", () => {
    const b = bundleOf({
      "a.md": "The retry budget is the number of attempts allowed.\n",
      "b.md": "The retry-budget is the wall-clock time spent retrying.\n",
    });
    const hit = buildTermInventory(b).find((c) => c.key === "retry budget");
    expect(hit).toBeDefined();
    expect(hit!.sites).toHaveLength(2);
    expect(hit!.meta.definitional).toBe(2);
  });

  test("a term nobody ever defines is not drift, just a word", () => {
    const b = bundleOf({
      "a.md": "We ran the retry budget yesterday.\n",
      "b.md": "Someone mentioned the retry-budget again.\n",
    });
    expect(buildTermInventory(b).some((c) => c.key === "retry budget")).toBe(false);
  });

  test("one definition and one passing mention is not a candidate", () => {
    const b = bundleOf({
      "a.md": "The retry budget is the number of attempts allowed.\n",
      "b.md": "Set the retry-budget before you deploy.\n",
    });
    expect(buildTermInventory(b).some((c) => c.key === "retry budget")).toBe(false);
  });

  test("a term merely sharing a line with a modal is not defined by it", () => {
    // An earlier version counted any sentence containing "must" as
    // definitional, which on real documentation makes almost everything a
    // candidate. Commands are the directive inventory's job.
    const b = bundleOf({
      "a.md": "You must set the retry budget carefully.\n",
      "b.md": "You must review the retry-budget quarterly.\n",
    });
    expect(buildTermInventory(b).some((c) => c.key === "retry budget")).toBe(false);
  });

  test("a single occurrence is never a cluster", () => {
    const b = bundleOf({ "a.md": "The retry budget is five.\n" });
    expect(buildTermInventory(b).some((c) => c.key === "retry budget")).toBe(false);
  });

  test("changelog and code content stays out", () => {
    const b = bundleOf({
      "a.md": "The retry budget is five.\n\n## Changelog\n\nThe retry-budget was three.\n",
      "b.md": "```\nretry_budget = 9\n```\n",
    });
    const hit = buildTermInventory(b).find((c) => c.key === "retry budget");
    // Only the one visible definitional site remains, which is below the bar.
    expect(hit).toBeUndefined();
  });

  test("cross-document clusters sort ahead of single-document ones", () => {
    const b = bundleOf({
      // Two lines: one line contributes at most one site per term, so a
      // single-document cluster still needs two distinct places.
      "a.md": "A widget cache is a warm store.\nThe widget cache is a required component.\n",
      "b.md": "The retry budget is five attempts.\n",
      "c.md": "A retry-budget is a time limit.\n",
    });
    const keys = buildTermInventory(b).map((c) => c.key);
    expect(keys).toContain("retry budget");
    expect(keys).toContain("widget cache");
    expect(keys.indexOf("retry budget")).toBeLessThan(keys.indexOf("widget cache"));
  });
});

describe("numeric inventory", () => {
  test("same subject, different values, across documents", () => {
    const b = bundleOf({
      "a.md": "The request timeout is 30s.\n",
      "b.md": "Set the request timeout to 60s.\n",
    });
    const hit = buildNumericInventory(b).find((c) => c.key.startsWith("duration:"));
    expect(hit).toBeDefined();
    expect(hit!.meta.values.sort()).toEqual(["30s", "60s"]);
    expect(hit!.sites).toHaveLength(2);
  });

  test("agreement produces nothing", () => {
    const b = bundleOf({ "a.md": "The request timeout is 30s.\n", "b.md": "The request timeout is 30s.\n" });
    expect(buildNumericInventory(b)).toHaveLength(0);
  });

  test("the same magnitude in different units is a spelling difference, not a conflict", () => {
    const b = bundleOf({ "a.md": "The request timeout is 60s.\n", "b.md": "The request timeout is 1m.\n" });
    expect(buildNumericInventory(b)).toHaveLength(0);
  });

  test("different subjects with the same number do not join", () => {
    const b = bundleOf({ "a.md": "The request timeout is 30s.\n", "b.md": "The retry delay is 45s.\n" });
    expect(buildNumericInventory(b)).toHaveLength(0);
  });

  test("code fences ARE read, so a sample can contradict the prose around it", () => {
    const b = bundleOf({
      "a.md": "The request timeout is 60s.\n\n```yaml\nrequest timeout: 30s\n```\n",
    });
    const hit = buildNumericInventory(b).find((c) => c.key.startsWith("duration:"));
    expect(hit).toBeDefined();
    expect(hit!.meta.values.sort()).toEqual(["30s", "60s"]);
  });

  test("a changelog's stale number never reaches the lens", () => {
    const b = bundleOf({
      "a.md": "The request timeout is 60s.\n\n## Changelog\n\nThe request timeout was 10s.\n",
    });
    expect(buildNumericInventory(b)).toHaveLength(0);
  });

  test("versions, percents and ports are tracked", () => {
    const b = bundleOf({
      "a.md": "Requires node 18.0 and coverage 80%. Listen on port 8080.\n",
      "b.md": "Requires node 20.0 and coverage 90%. Listen on port 3000.\n",
    });
    const kinds = new Set(buildNumericInventory(b).map((c) => c.meta.kind));
    expect(kinds.has("version")).toBe(true);
    expect(kinds.has("percent")).toBe(true);
    expect(kinds.has("port")).toBe(true);
  });

  test("a grouped number is one value, not two", () => {
    // Found by running the skill on its own docs: "25,000" scanned as 25 and
    // 000, and every mention of the ceiling reported a conflict with itself.
    const b = bundleOf({ "a.md": "The line ceiling is 25,000 lines.\n" });
    expect(buildNumericInventory(b)).toHaveLength(0);
  });

  test("a grouped and an ungrouped spelling of one number do not conflict", () => {
    const b = bundleOf({ "a.md": "The ceiling is 25,000 lines.\n", "b.md": "The ceiling is 25000 lines.\n" });
    expect(buildNumericInventory(b)).toHaveLength(0);
  });

  test("a real conflict between grouped numbers is still caught", () => {
    const b = bundleOf({ "a.md": "The ceiling is 25,000 lines.\n", "b.md": "The ceiling is 50,000 lines.\n" });
    const hit = buildNumericInventory(b).find((c) => c.key.includes("ceiling"));
    expect(hit).toBeDefined();
    expect(hit!.meta.values.sort()).toEqual(["25,000", "50,000"]);
  });

  test("two values on one line are a range or a list, not a conflict", () => {
    // Also found by dogfooding: "medium 4-7" and "capped at 3, 10 when..." both
    // scanned as a subject carrying two disagreeing values.
    const b = bundleOf({ "a.md": "The band is medium 4-7 in this scheme.\n" });
    expect(buildNumericInventory(b)).toHaveLength(0);
  });

  test("the same two values in two places still conflict", () => {
    const b = bundleOf({ "a.md": "The band is medium 4.\n", "b.md": "The band is medium 7.\n" });
    expect(buildNumericInventory(b).length).toBeGreaterThan(0);
  });

  test("numbered headings are labels in a sequence, not conflicting quantities", () => {
    const b = bundleOf({ "a.md": "## Step 1\ntext\n## Step 2\ntext\n## Step 3\ntext\n" });
    expect(buildNumericInventory(b)).toHaveLength(0);
  });

  test("durationToMs converts the units it claims to", () => {
    expect(durationToMs(1, "s")).toBe(1000);
    expect(durationToMs(2, "minutes")).toBe(120000);
    expect(durationToMs(1, "furlong")).toBeNull();
  });

  test("numericSubject takes the meaningful words before the number", () => {
    expect(numericSubject("the request timeout is 30s", "the request timeout is ".length)).toBe("request timeout");
  });
});

describe("directive inventory", () => {
  test("opposite polarity on the same action is surfaced", () => {
    const b = bundleOf({
      "a.md": "You must run migrations before deploying.\n",
      "b.md": "Never run migrations before deploying.\n",
    });
    // The key is the two content words SORTED, so word order cannot split a
    // pair that says the same thing in a different arrangement.
    const hit = buildDirectiveInventory(b).find((c) => c.key === "migration run");
    expect(hit).toBeDefined();
    expect(hit!.meta.polarities.sort()).toEqual(["negative", "positive"]);
  });

  test("the subject key survives the negation moving to the other side of the modal", () => {
    const b = bundleOf({
      "a.md": "You must run migrations before deploying.\n",
      "b.md": "Migrations must never run before a deploy.\n",
    });
    const hit = buildDirectiveInventory(b).find((c) => c.key === "migration run");
    expect(hit).toBeDefined();
    expect(hit!.meta.polarities.sort()).toEqual(["negative", "positive"]);
  });

  test("agreement on the same action produces nothing", () => {
    const b = bundleOf({
      "a.md": "You must run migrations before deploying.\n",
      "b.md": "You must run migrations before deploying.\n",
    });
    expect(buildDirectiveInventory(b)).toHaveLength(0);
  });

  test("a strength difference alone is enough to surface", () => {
    const b = bundleOf({
      "a.md": "You must pin dependencies.\n",
      "b.md": "You should pin dependencies.\n",
    });
    const hit = buildDirectiveInventory(b).find((c) => c.key === "dependency pin");
    expect(hit).toBeDefined();
    expect(hit!.meta.strengths.sort()).toEqual(["must", "should"]);
  });

  test("example sections are excluded, so a deliberate anti-pattern stays quiet", () => {
    const b = bundleOf({
      "a.md": "You must run migrations before deploying.\n\n## Anti-patterns\n\nNever run migrations before deploying.\n",
    });
    expect(buildDirectiveInventory(b)).toHaveLength(0);
  });

  test("directiveSubject keys on the two content words, sorted and modal-free", () => {
    expect(directiveSubject("You must run migrations before deploying")).toBe("migration run");
    expect(directiveSubject("Migrations must never run before a deploy")).toBe("migration run");
    expect(directiveSubject("Never delete the production database")).toBe("delete production");
  });
});

describe("splitSentences", () => {
  test("does not split on a decimal or a version", () => {
    expect(splitSentences("Use v1.2.3 here. Then stop.").map((s) => s.text)).toEqual(["Use v1.2.3 here.", "Then stop."]);
  });

  test("handles a line with no terminator", () => {
    expect(splitSentences("no terminator here").map((s) => s.text)).toEqual(["no terminator here"]);
  });
});

describe("link inventory", () => {
  test("collects same-document and cross-document references, skipping external", () => {
    const b = bundleOf({
      "a.md": "See [x](#intro) and [y](b.md#setup) and [z](https://example.com).\n",
      "b.md": "# Setup\n",
    });
    const links = buildLinkInventory(b);
    expect(links).toHaveLength(2);
    expect(links[0].anchor).toBe("intro");
    expect(links[1].filePart).toBe("b.md");
    expect(links[1].anchor).toBe("setup");
  });

  test("a link inside a code fence is not a link", () => {
    const b = bundleOf({ "a.md": "```\n[x](#nope)\n```\n" });
    expect(buildLinkInventory(b)).toHaveLength(0);
  });
});

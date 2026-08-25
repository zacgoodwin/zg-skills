// Gate tests for lib/shard.ts and lib/prompts.ts.
//
// Sharding correctness is mostly an addressing question: a piece that claims
// lines 40-90 must render exactly those lines, or every citation downstream is
// off. Prompts get golden-ish assertions on the three rules that lose a whole
// run when they go missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle, type Bundle } from "../lib/bundle.ts";
import { directiveBrief, numericBrief, reduceBrief, refuteBrief, shardBrief, termBrief } from "../lib/prompts.ts";
import {
  batchShards,
  MAX_SHARD_AGENTS,
  MAX_SHARD_LINES,
  planShards,
  renderShard,
  TARGET_SHARD_LINES,
} from "../lib/shard.ts";

let scratch: string;
let n = 0;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "shard-test-"));
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

function paras(count: number, word: string): string {
  return Array.from({ length: count }, (_, i) => `${word} line ${i}`).join("\n");
}

describe("planShards", () => {
  test("a small document set is one shard", () => {
    const b = bundleOf({ "a.md": "# A\ntext\n", "b.md": "# B\ntext\n" });
    const shards = planShards(b);
    expect(shards).toHaveLength(1);
    expect(shards[0].pieces).toHaveLength(2);
  });

  test("every line of every document lands in exactly one piece", () => {
    const b = bundleOf({
      "a.md": `# One\n${paras(900, "a")}\n## Two\n${paras(900, "b")}\n`,
      "c.md": `# Three\n${paras(400, "c")}\n`,
    });
    const shards = planShards(b);
    const covered = new Map<string, Set<number>>();
    for (const s of shards) {
      for (const p of s.pieces) {
        const set = covered.get(p.docId) ?? new Set<number>();
        for (let ln = p.startLine; ln <= p.endLine; ln++) {
          expect(set.has(ln)).toBe(false); // no line covered twice
          set.add(ln);
        }
        covered.set(p.docId, set);
      }
    }
    for (const doc of b.docs) {
      expect(covered.get(doc.id)?.size).toBe(doc.lines.length);
    }
  });

  test("no shard exceeds the hard ceiling", () => {
    const b = bundleOf({ "a.md": `# One\n${paras(5000, "x")}\n` });
    for (const s of planShards(b)) expect(s.lines).toBeLessThanOrEqual(MAX_SHARD_LINES);
  });

  test("an oversized single section is split, and the parts say so", () => {
    const b = bundleOf({ "a.md": `# Huge\n${paras(4000, "x")}\n` });
    const shards = planShards(b);
    expect(shards.length).toBeGreaterThan(1);
    expect(shards[0].pieces[0].heading).toBe("Huge");
    expect(shards[1].pieces[0].heading).toMatch(/continued/);
  });

  test("a document with no headings still shards", () => {
    const b = bundleOf({ "a.txt": paras(4000, "x") + "\n" });
    const shards = planShards(b);
    expect(shards.length).toBeGreaterThan(1);
    expect(shards[0].pieces[0].heading).toBeNull();
  });

  test("preamble before the first heading is not lost", () => {
    const b = bundleOf({ "a.md": "intro line\nanother\n# First\nbody\n" });
    const pieces = planShards(b).flatMap((s) => s.pieces);
    expect(pieces[0]).toMatchObject({ startLine: 1, endLine: 2, heading: null });
  });

  test("small sections pack together rather than becoming one shard each", () => {
    const docs: Record<string, string> = {};
    for (let i = 0; i < 20; i++) docs[`d${i}.md`] = `# H${i}\nshort\n`;
    expect(planShards(bundleOf(docs))).toHaveLength(1);
  });

  test("shard ids are sequential and stable", () => {
    const b = bundleOf({ "a.md": `# One\n${paras(5000, "x")}\n` });
    const shards = planShards(b);
    expect(shards.map((s) => s.id)).toEqual(shards.map((_, i) => `shard-${i + 1}`));
    expect(planShards(b).map((s) => s.id)).toEqual(shards.map((s) => s.id));
  });
});

describe("batchShards", () => {
  test("under the cap, one shard per agent", () => {
    const shards = planShards(bundleOf({ "a.md": "# A\ntext\n" }));
    expect(batchShards(shards)).toEqual([[shards[0]]]);
  });

  test("over the cap, shards ride together and none is dropped", () => {
    const fake = Array.from({ length: 37 }, (_, i) => ({ id: `shard-${i + 1}`, pieces: [], lines: 10 }));
    const batches = batchShards(fake, MAX_SHARD_AGENTS);
    expect(batches.length).toBeLessThanOrEqual(MAX_SHARD_AGENTS);
    expect(batches.flat()).toHaveLength(37);
    expect(batches.flat().map((s) => s.id)).toEqual(fake.map((s) => s.id));
  });
});

describe("renderShard", () => {
  test("renders exactly the lines a piece claims", () => {
    const b = bundleOf({ "a.md": "one\ntwo\nthree\nfour\n" });
    const shard = { id: "shard-1", lines: 2, pieces: [{ docId: "D1", relPath: "a.md", startLine: 2, endLine: 3, heading: null }] };
    const text = renderShard(b, shard, "contradiction");
    expect(text).toContain("two");
    expect(text).toContain("three");
    expect(text).not.toContain("one");
    expect(text).not.toContain("four");
  });

  test("withheld regions are marked, not silently dropped", () => {
    const b = bundleOf({ "a.md": "prose\n```\nsecret code\n```\nmore prose\n" });
    const shard = {
      id: "shard-1",
      lines: 5,
      pieces: [{ docId: "D1", relPath: "a.md", startLine: 1, endLine: 5, heading: null }],
    };
    const text = renderShard(b, shard, "contradiction");
    expect(text).not.toContain("secret code");
    expect(text).toMatch(/3 line\(s\) withheld/);
    expect(text).toContain("more prose");
  });

  test("the numeric lens is given code fences", () => {
    const b = bundleOf({ "a.md": "prose\n```\ntimeout: 30\n```\n" });
    const shard = {
      id: "shard-1",
      lines: 4,
      pieces: [{ docId: "D1", relPath: "a.md", startLine: 1, endLine: 4, heading: null }],
    };
    expect(renderShard(b, shard, "numeric")).toContain("timeout: 30");
  });

  test("the header names the document and its true line range", () => {
    const b = bundleOf({ "a.md": "one\ntwo\n" });
    const shard = { id: "shard-1", lines: 2, pieces: [{ docId: "D1", relPath: "a.md", startLine: 1, endLine: 2, heading: null }] };
    expect(renderShard(b, shard, "contradiction")).toContain("===== D1 a.md lines 1-2 =====");
  });

  test("an unknown document id is an error, not an empty render", () => {
    const b = bundleOf({ "a.md": "one\n" });
    const shard = { id: "shard-1", lines: 1, pieces: [{ docId: "D9", relPath: "x.md", startLine: 1, endLine: 1, heading: null }] };
    expect(() => renderShard(b, shard, "contradiction")).toThrow(/unknown document D9/);
  });
});

describe("briefs", () => {
  const b = () => bundleOf({ "a.md": "# A\nThe timeout is 30s.\n" });

  // The three rules whose absence loses a whole run: quotes must be verbatim,
  // no option may be recommended, and nothing outside the bundle may be read.
  const RULES = [/character-for-character/, /NOT deciding which passage is right/, /strictly internal/];

  test("every discovery brief carries all three rules and the output contract", () => {
    const bundle = b();
    const shard = planShards(bundle)[0];
    const briefs = [
      shardBrief({
        bundle,
        shard,
        shardText: renderShard(bundle, shard, "contradiction"),
        findingsPath: "/run/findings.json",
        claimsPath: "/run/claims.json",
      }),
      termBrief([], "/run/findings.json"),
      numericBrief([], "/run/findings.json"),
      directiveBrief([], "/run/findings.json"),
      reduceBrief([], "/run/findings.json"),
    ];
    for (const brief of briefs) {
      for (const rule of RULES) expect(brief).toMatch(rule);
      expect(brief).toContain("/run/findings.json");
      expect(brief).toContain("findings written");
      expect(brief).toMatch(/No severity, no confidence/);
    }
  });

  test("the shard brief demands both files", () => {
    const bundle = b();
    const shard = planShards(bundle)[0];
    const brief = shardBrief({
      bundle,
      shard,
      shardText: "text",
      findingsPath: "/run/f.json",
      claimsPath: "/run/c.json",
    });
    expect(brief).toContain("/run/c.json");
    expect(brief).toContain("Write BOTH files");
    expect(brief).toContain("text");
  });

  test("cluster briefs render every site with its address", () => {
    const brief = termBrief(
      [
        {
          key: "retry budget",
          sites: [
            { docId: "D1", relPath: "a.md", line: 4, context: "The retry budget is five." },
            { docId: "D2", relPath: "b.md", line: 9, context: "The retry-budget must be set." },
          ],
          meta: { surfaces: ["retry budget", "retry-budget"], definitional: 2 },
        },
      ],
      "/run/f.json"
    );
    expect(brief).toContain("D1 a.md:4");
    expect(brief).toContain("D2 b.md:9");
    expect(brief).toContain('"retry-budget"');
  });

  test("a very large cluster is capped with the remainder stated, not silently cut", () => {
    const sites = Array.from({ length: 60 }, (_, i) => ({ docId: "D1", relPath: "a.md", line: i + 1, context: `line ${i}` }));
    const brief = termBrief([{ key: "x", sites, meta: { surfaces: ["x"], definitional: 1 } }], "/run/f.json");
    expect(brief).toMatch(/and 20 more occurrences/);
  });

  test("the reduce brief insists the contradiction be visible in the quotes", () => {
    const brief = reduceBrief(
      [{ shardId: "shard-1", subject: "friday deploys", assertion: "Friday deploys are fine", quote: "Deploying on Friday is fine." }],
      "/run/f.json"
    );
    expect(brief).toMatch(/visible in the QUOTED SOURCE TEXT/);
    expect(brief).toContain("Deploying on Friday is fine.");
  });

  test("the reduce brief's worked example does not give away the eval fixture", () => {
    // The example used to be a near-copy of the fixture's seeded no-shared-
    // vocabulary defect, which meant the eval was partly measuring whether the
    // agent could pattern-match its own prompt.
    const brief = reduceBrief([], "/run/f.json");
    for (const leak of [/friday/i, /end of the week/i, /deploy/i, /migration/i, /retry budget/i, /api key/i, /timeout/i]) {
      expect(brief, `reduce brief example leaks ${leak}`).not.toMatch(leak);
    }
  });

  test("the refuter defaults to REFUTED and is told to attack, not review", () => {
    const brief = refuteBrief({
      findingTitle: "Token lifetime disagrees",
      findingSummary: "two values",
      kind: "contradiction",
      sides: [{ label: "A", quote: "Tokens last 7 days.", context: "1 > Tokens last 7 days." }],
      verdictPath: "/run/verdict.json",
      verdictBlock: "VERDICT CONTRACT HERE",
    });
    expect(brief).toMatch(/trying to kill it/);
    expect(brief).toMatch(/Your default is REFUTED/);
    expect(brief).toMatch(/Unsure is\nREFUTED/);
    expect(brief).toContain("VERDICT CONTRACT HERE");
    expect(brief).toMatch(/strictly internal/);
  });

  test("the refuter is never handed the resolution options it might rubber-stamp", () => {
    const brief = refuteBrief({
      findingTitle: "t",
      findingSummary: "s",
      kind: "contradiction",
      sides: [{ label: "A", quote: "q", context: "c" }],
      verdictPath: "/run/v.json",
      verdictBlock: "block",
    });
    expect(brief).not.toMatch(/align on/);
    expect(brief).not.toMatch(/consequence/);
  });
});

describe("shard sizing constants stay coherent", () => {
  test("target is under the ceiling and over the floor", () => {
    expect(TARGET_SHARD_LINES).toBeLessThan(MAX_SHARD_LINES);
    expect(TARGET_SHARD_LINES).toBeGreaterThan(200);
  });
});

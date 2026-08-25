// The deterministic half of the eval, run as a gate test.
//
// evals/fixtures/drifted holds two documents carrying seven seeded defects and
// seven deliberate traps. Measuring whether an AGENT finds the latent ones
// costs money and lives in evals/. But every seeded defect first has to become
// a CANDIDATE -- a cluster, a directive group, or a structure finding -- and
// every trap first has to be excluded. That part is free, deterministic, and
// exactly where this pipeline most easily goes silently wrong.
//
// A regression here means agents are being asked the wrong questions, which no
// amount of model quality downstream can fix.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadBundle, type Bundle } from "../lib/bundle.ts";
import {
  buildDirectiveInventory,
  buildNumericInventory,
  buildTermInventory,
} from "../lib/inventory.ts";
import { resolveQuote } from "../lib/findings.ts";
import { structureFindings } from "../lib/structure.ts";

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const FIXTURE = join(here, "..", "evals", "fixtures", "drifted");
const truth = JSON.parse(readFileSync(join(FIXTURE, "defects.json"), "utf8"));

function fixture(): Bundle {
  return loadBundle(["guide.md", "reference.md"], FIXTURE, FIXTURE);
}

// Every site of a cluster, as "relPath:line", for readable assertions.
function sitesOf(cluster: { sites: { relPath: string; line: number }[] } | undefined): string[] {
  return (cluster?.sites ?? []).map((s) => `${s.relPath}:${s.line}`);
}

describe("the fixture itself is well formed", () => {
  test("every ground-truth phrase resolves in the documents", () => {
    // A phrase that does not appear verbatim can never be matched, so a typo in
    // ground truth would silently show up as a recall failure in the skill.
    const b = fixture();
    for (const d of truth.seeded) {
      for (const side of d.sides) {
        for (const p of side) {
          expect(resolveQuote(b, p).length, `${d.id}: ${JSON.stringify(p)}`).toBeGreaterThan(0);
        }
      }
    }
    for (const t of truth.traps) {
      for (const p of t.phrases ?? []) {
        expect(resolveQuote(b, p).length, `trap ${t.id}: ${JSON.stringify(p)}`).toBeGreaterThan(0);
      }
    }
  });

  test("every seeded defect has at least one side, and multi-sided ones have two", () => {
    for (const d of truth.seeded) {
      expect(d.sides.length, d.id).toBeGreaterThan(0);
      for (const side of d.sides) expect(side.length, d.id).toBeGreaterThan(0);
    }
  });

  test("it carries both seeded defects and traps, or it measures nothing", () => {
    expect(truth.seeded.length).toBeGreaterThanOrEqual(6);
    expect(truth.traps.length).toBeGreaterThanOrEqual(6);
  });
});

describe("numeric candidates", () => {
  const clusters = () => buildNumericInventory(fixture());

  test("the 30s / 60s timeout conflict is surfaced across both documents", () => {
    const hit = clusters().find((c) => c.key.includes("request timeout"));
    expect(hit).toBeDefined();
    expect(hit!.meta.values.sort()).toEqual(["30s", "60s"]);
    expect(new Set(hit!.sites.map((s) => s.relPath)).size).toBe(2);
  });

  test("the config sample's 60s is included, since the numeric lens reads code", () => {
    const hit = clusters().find((c) => c.key.includes("request timeout"));
    // reference.md:15 is `  request timeout: 60s`, inside the yaml fence.
    expect(sitesOf(hit)).toContain("reference.md:15");
  });

  test("the free tier 100 / 200 conflict is surfaced", () => {
    const hit = clusters().find((c) => c.key.includes("free tier"));
    expect(hit).toBeDefined();
    expect(hit!.meta.values.sort()).toEqual(["100", "200"]);
  });

  test("TRAP: the changelog's old 10s timeout never becomes a candidate", () => {
    const hit = clusters().find((c) => c.key.includes("request timeout"));
    expect(hit!.meta.values).not.toContain("10s");
    expect(sitesOf(hit).every((s) => !s.startsWith("guide.md:6"))).toBe(true);
  });

  test("TRAP: free tier and paid tier are different subjects, not a conflict", () => {
    const paid = clusters().find((c) => c.key.includes("paid tier"));
    const free = clusters().find((c) => c.key.includes("free tier"));
    // If they had collapsed into one subject, 1000 would appear beside 100.
    expect(free?.meta.values).not.toContain("1000");
    if (paid) expect(paid.meta.values).not.toContain("100");
  });
});

describe("term candidates", () => {
  const clusters = () => buildTermInventory(fixture());

  test("\"API key\" is surfaced, with both definitional sites", () => {
    const hit = clusters().find((c) => c.key === "api key");
    expect(hit).toBeDefined();
    expect(new Set(hit!.sites.map((s) => s.relPath)).size).toBe(2);
    expect(hit!.meta.definitional).toBeGreaterThanOrEqual(2);
  });

  test("\"retry budget\" is surfaced with both of its incompatible definitions", () => {
    const hit = clusters().find((c) => c.key === "retry budget");
    expect(hit).toBeDefined();
    const paths = new Set(hit!.sites.map((s) => s.relPath));
    expect(paths.has("guide.md")).toBe(true);
    expect(paths.has("reference.md")).toBe(true);
  });

  test("TRAP: the changelog's mention of the retry budget is not one of its sites", () => {
    const hit = clusters().find((c) => c.key === "retry budget");
    // guide.md's changelog sits at the end of the file.
    const changelogStart = readFileSync(join(FIXTURE, "guide.md"), "utf8").split("\n").findIndex((l) => /^## Changelog/.test(l)) + 1;
    for (const s of hit!.sites) {
      if (s.relPath === "guide.md") expect(s.line).toBeLessThan(changelogStart);
    }
  });
});

describe("directive candidates", () => {
  const clusters = () => buildDirectiveInventory(fixture());

  test("the migrations-before-deploy conflict is surfaced with both polarities", () => {
    const hit = clusters().find((c) => c.key.includes("run migration") || c.key.includes("migration"));
    expect(hit).toBeDefined();
    expect(hit!.meta.polarities.sort()).toEqual(["negative", "positive"]);
  });

  test("TRAP: the anti-pattern example's \"never retry a 4xx\" is excluded", () => {
    // The Examples section states the same rule the guide states. If the
    // example region leaked in, a "retry" cluster would show both polarities
    // from a section that exists to demonstrate the rule.
    const guide = readFileSync(join(FIXTURE, "guide.md"), "utf8").split("\n");
    const exampleStart = guide.findIndex((l) => /^## Examples/.test(l)) + 1;
    const exampleEnd = guide.findIndex((l) => /^## Changelog/.test(l));
    for (const c of clusters()) {
      for (const s of c.sites) {
        if (s.relPath !== "guide.md") continue;
        const inExample = s.line >= exampleStart && s.line < exampleEnd;
        expect(inExample, `${c.key} cited guide.md:${s.line}, inside the Examples section`).toBe(false);
      }
    }
  });
});

describe("structure findings, with no model", () => {
  test("the duplicate #errors heading is found outright", () => {
    const { findings } = structureFindings(fixture());
    const dupe = findings.find((f) => f.title.includes("Duplicate heading") && f.title.includes("errors"));
    expect(dupe).toBeDefined();
    expect(dupe!.sides.length).toBe(2);
  });

  test("TRAP: the working cross-document link is not reported as broken", () => {
    const { findings, unverifiableRefs } = structureFindings(fixture());
    expect(findings.some((f) => f.title.includes("Dangling"))).toBe(false);
    expect(unverifiableRefs).toEqual([]);
  });
});

describe("cross-shard reach", () => {
  test("the Friday-deploy contradiction shares no vocabulary, so only the reduce pass can catch it", () => {
    // This is the claim ledger's reason to exist. Assert the mechanical
    // inventories genuinely cannot join these two -- if one ever does, the
    // fixture has lost the case it was built to measure.
    const b = fixture();
    const joined = [
      ...buildNumericInventory(b).map((c) => c.key),
      ...buildTermInventory(b).map((c) => c.key),
      ...buildDirectiveInventory(b).map((c) => c.key),
    ];
    const friday = truth.seeded.find((d: any) => d.id === "friday-deploys");
    expect(friday.vocabularyOverlap).toBe(false);

    // The property that makes this defect worth having: its two sides share no
    // content word, so no key built from either side can contain the other's.
    const stop = new Set(["is", "the", "at", "on", "a", "as", "long", "it", "of"]);
    const words = (s: string) =>
      new Set(
        (s.toLowerCase().match(/\b[a-z]+\b/g) ?? [])
          .filter((w) => !stop.has(w))
          .map((w) => w.replace(/s$/, ""))
      );
    const left = words(friday.sides[0][0]);
    const right = words(friday.sides[1][0]);
    for (const w of left) expect(right.has(w), `both sides contain ${JSON.stringify(w)}`).toBe(false);

    // And no mechanical cluster joins them.
    for (const key of joined) {
      const hitsLeft = [...left].some((w) => key.includes(w));
      const hitsRight = [...right].some((w) => key.includes(w));
      expect(hitsLeft && hitsRight, `cluster ${JSON.stringify(key)} joins both sides`).toBe(false);
    }
  });

  test("both halves of it are quotable, so the reduce pass can ground its finding", () => {
    const b = fixture();
    const friday = truth.seeded.find((d: any) => d.id === "friday-deploys");
    for (const side of friday.sides) for (const p of side) expect(resolveQuote(b, p).length).toBe(1);
  });
});

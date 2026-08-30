// Gate tests for the outside-CLI discovery brief and its split.
//
// The bug these exist for: a review of 7 files composed a 1,468,325-char brief
// and BOTH CLI seats died before reading a word -- codex on its 1,048,576-char
// server-side input cap, agy on the Windows argv limit -- while the plan said
// only "1 discovery seat(s) wrote nothing". Size is now decided in code, and a
// brief too big for one invocation is split rather than truncated or skipped.
import { describe, expect, test } from "bun:test";
import { cliDiscoverBrief, splitCliDiscoverBrief, type ClusterGroup } from "../lib/prompts.ts";
import type { Cluster, DirectiveMeta, NumericMeta, Site, TermMeta } from "../lib/inventory.ts";

function sites(n: number, pad = 0): Site[] {
  return Array.from({ length: n }, (_, i) => ({
    docId: `D${(i % 3) + 1}`,
    relPath: `doc${(i % 3) + 1}.md`,
    line: i + 1,
    context: `a line of context${"x".repeat(pad)}`,
  }));
}

const term = (key: string, siteCount = 4, pad = 0): Cluster<TermMeta> => ({
  key,
  sites: sites(siteCount, pad),
  meta: { surfaces: [key, key.toUpperCase()], definitional: 2 },
});

const numeric = (key: string): Cluster<NumericMeta> => ({
  key,
  sites: sites(3),
  meta: { kind: "duration", subject: key, values: ["24h", "7d"] },
});

const directive = (key: string): Cluster<DirectiveMeta> => ({
  key,
  sites: sites(3),
  meta: { subject: key, polarities: ["positive", "negative"], strengths: ["must", "may"] },
});

const group = (over: Partial<ClusterGroup> = {}): ClusterGroup => ({
  terms: [],
  numerics: [],
  directives: [],
  ...over,
});

const FINDINGS = "/run/seat/findings.json";

describe("cliDiscoverBrief", () => {
  test("carries all three cluster kinds and the seat's own output path", () => {
    const text = cliDiscoverBrief(group({ terms: [term("token")], numerics: [numeric("timeout")], directives: [directive("deploy")] }), FINDINGS);
    expect(text).toContain('Cluster 1: "token"');
    expect(text).toContain("ALSO CHECK THESE NUMERIC CLUSTERS");
    expect(text).toContain("ALSO CHECK THESE DIRECTIVE CLUSTERS");
    expect(text).toContain(FINDINGS);
  });
});

describe("splitCliDiscoverBrief", () => {
  const g = group({
    terms: [term("token"), term("session"), term("scope"), term("lease")],
    numerics: [numeric("timeout")],
    directives: [directive("deploy")],
  });

  test("a brief under the cap is one part, and that part is the brief itself", () => {
    const parts = splitCliDiscoverBrief(g, FINDINGS, 1_048_576);
    expect(parts.length).toBe(1);
    expect(cliDiscoverBrief(parts[0], FINDINGS)).toBe(cliDiscoverBrief(g, FINDINGS));
  });

  // Every part carries the same three contracts, so no part is smaller than that
  // fixed preamble however few clusters it holds. Caps below that floor cannot
  // be met by splitting, so the caps here are derived from a real rendering
  // rather than picked as a fraction.
  const capFor = (over: Partial<ClusterGroup>) => cliDiscoverBrief(group(over), FINDINGS).length;

  test("over the cap it splits, and every part fits", () => {
    const cap = capFor({ terms: g.terms.slice(0, 2) });
    const parts = splitCliDiscoverBrief(g, FINDINGS, cap);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(cliDiscoverBrief(p, FINDINGS).length).toBeLessThanOrEqual(cap);
  });

  test("no cluster is dropped and none is reviewed twice", () => {
    const cap = capFor({ terms: g.terms.slice(0, 1) });
    const parts = splitCliDiscoverBrief(g, FINDINGS, cap);
    const keys = (k: keyof ClusterGroup) => parts.flatMap((p) => (p[k] as { key: string }[]).map((c) => c.key));
    expect(keys("terms").sort()).toEqual(g.terms.map((c) => c.key).sort());
    expect(keys("numerics")).toEqual(g.numerics.map((c) => c.key));
    expect(keys("directives")).toEqual(g.directives.map((c) => c.key));
    expect(new Set(keys("terms")).size).toBe(g.terms.length);
  });

  test("a single cluster too big to split is returned whole, for the composer to refuse", () => {
    // Never truncated: half a rendered cluster is a quote with no sites, and a
    // seat that silently reviewed half its material is the failure being fixed.
    const huge = group({ terms: [term("token", 40, 5000)] });
    const parts = splitCliDiscoverBrief(huge, FINDINGS, 1000);
    expect(parts.length).toBe(1);
    expect(parts[0].terms.length).toBe(1);
    expect(cliDiscoverBrief(parts[0], FINDINGS).length).toBeGreaterThan(1000);
  });
});

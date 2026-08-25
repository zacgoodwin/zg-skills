// Gate tests for lib/structure.ts: the lens that produces findings with no
// model involved. Every finding it emits must also survive resolveAndMerge --
// a structure finding that cannot ground its own quotes would be a bug in the
// one lens that has no excuse for it, so the round-trip is asserted here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle, type Bundle } from "../lib/bundle.ts";
import { resolveAndMerge } from "../lib/findings.ts";
import { structureFindings, STRUCTURE_SEAT, tocEntries } from "../lib/structure.ts";

let scratch: string;
let n = 0;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "struct-test-"));
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

describe("dangling anchors", () => {
  test("a same-document anchor with no heading is a finding", () => {
    const b = bundleOf({ "a.md": "# Intro\n\nSee [setup](#setup).\n" });
    const { findings } = structureFindings(b);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toMatch(/Dangling anchor #setup/);
  });

  test("a resolving anchor produces nothing", () => {
    const b = bundleOf({ "a.md": "# Setup\n\nSee [setup](#setup).\n" });
    expect(structureFindings(b).findings).toHaveLength(0);
  });

  test("a cross-document anchor resolves against the other document in the set", () => {
    const ok = bundleOf({ "a.md": "See [s](b.md#setup).\n", "b.md": "# Setup\n" });
    expect(structureFindings(ok).findings).toHaveLength(0);

    const bad = bundleOf({ "a.md": "See [s](b.md#missing).\n", "b.md": "# Setup\n" });
    expect(structureFindings(bad).findings).toHaveLength(1);
  });

  test("an explicit HTML or attribute anchor counts as a target", () => {
    const b = bundleOf({ "a.md": '<a id="deep"></a>\n\nSee [d](#deep).\n' });
    expect(structureFindings(b).findings).toHaveLength(0);
    const b2 = bundleOf({ "a.md": "## Thing {#custom}\n\nSee [c](#custom).\n" });
    expect(structureFindings(b2).findings).toHaveLength(0);
  });

  test("a near-miss anchor is offered as the repoint target", () => {
    const b = bundleOf({ "a.md": "# Setup Guide\n\nSee [s](#setup).\n" });
    const f = structureFindings(b).findings[0];
    expect(f.summary).toMatch(/setup-guide/);
    expect(f.options[0].label).toMatch(/#setup-guide/);
  });

  test("every option declares at least one grounded edit", () => {
    const b = bundleOf({ "a.md": "# Intro\n\nSee [setup](#setup).\n" });
    const { findings } = structureFindings(b);
    const resolved = resolveAndMerge(b, [{ seat: STRUCTURE_SEAT, findings }]);
    expect(resolved.unverifiable).toEqual([]);
    expect(resolved.findings[0].options.every((o) => o.editSites.length > 0)).toBe(true);
  });
});

describe("references outside the review set", () => {
  test("are recorded as unverifiable, never reported as broken", () => {
    const b = bundleOf({ "a.md": "See [c](CONTRIBUTING.md#rules).\n" });
    const { findings, unverifiableRefs } = structureFindings(b);
    expect(findings).toHaveLength(0);
    expect(unverifiableRefs).toHaveLength(1);
    expect(unverifiableRefs[0].reason).toMatch(/outside this review set/);
  });

  test("external URLs are not references at all", () => {
    const b = bundleOf({ "a.md": "See [x](https://example.com#frag) and [y](mailto:a@b.c).\n" });
    const { findings, unverifiableRefs } = structureFindings(b);
    expect(findings).toHaveLength(0);
    expect(unverifiableRefs).toHaveLength(0);
  });

  test("a link inside a code fence is documentation of a link, not a link", () => {
    const b = bundleOf({ "a.md": "# Intro\n\n```md\n[setup](#setup)\n```\n" });
    expect(structureFindings(b).findings).toHaveLength(0);
  });
});

describe("duplicate headings", () => {
  test("two headings sharing a slug are a finding with both occurrences cited", () => {
    const b = bundleOf({ "a.md": "## Options\ntext\n## Usage\ntext\n## Options\ntext\n" });
    const { findings } = structureFindings(b);
    expect(findings).toHaveLength(1);
    expect(findings[0].sides).toHaveLength(2);
    expect(findings[0].title).toMatch(/Duplicate heading "options"/);
  });

  test("distinct headings produce nothing", () => {
    const b = bundleOf({ "a.md": "## Options\n## Usage\n" });
    expect(structureFindings(b).findings).toHaveLength(0);
  });

  test("the same heading in two different documents is not a duplicate", () => {
    const b = bundleOf({ "a.md": "## Options\n", "b.md": "## Options\n" });
    expect(structureFindings(b).findings).toHaveLength(0);
  });

  test("a heading inside a code fence does not collide with a real one", () => {
    const b = bundleOf({ "a.md": "## Options\n\n```\n## Options\n```\n" });
    expect(structureFindings(b).findings).toHaveLength(0);
  });

  test("the rename option edits only the later occurrences", () => {
    const b = bundleOf({ "a.md": "## Options\ntext\n## Options\ntext\n" });
    const f = structureFindings(b).findings[0];
    const rename = f.options[0];
    expect(rename.label).toMatch(/Rename/);
    expect(rename.edits).toHaveLength(1);
  });

  test("identical headings stay distinguishable after resolution", () => {
    // Both occurrences quote the same text, so without a line pin every side
    // would resolve to every line and the citations would be useless.
    const b = bundleOf({ "a.md": "## Options\ntext\n## Other\n## Options\ntext\n" });
    const { findings } = structureFindings(b);
    const resolved = resolveAndMerge(b, [{ seat: STRUCTURE_SEAT, findings }]);
    expect(resolved.unverifiable).toEqual([]);
    const f = resolved.findings[0];
    expect(f.sides[0].instances.map((i) => i.line)).toEqual([1]);
    expect(f.sides[1].instances.map((i) => i.line)).toEqual([4]);
    expect(f.options[0].editSites.map((i) => i.line)).toEqual([4]);
  });

  test("every structure option's stated edit count matches the sites it resolves to", () => {
    const b = bundleOf({
      "a.md": "# G\n\n- [Install](#install)\n- [Gone](#gone)\n- [Also gone](#also-gone)\n\n## Install\n\nSee [x](#nope).\n\n## Dupe\n## Dupe\n",
    });
    const { findings } = structureFindings(b);
    const resolved = resolveAndMerge(b, [{ seat: STRUCTURE_SEAT, findings }]);
    expect(resolved.unverifiable).toEqual([]);
    for (const f of resolved.findings) {
      for (const o of f.options) {
        const stated = /^(\d+) edit/.exec(o.consequence)?.[1];
        if (stated) expect(o.editSites.length, `${f.title} / option ${o.id}`).toBe(Number(stated));
      }
    }
  });
});

describe("table of contents drift", () => {
  const doc = [
    "# Guide",
    "",
    "- [Install](#install)",
    "- [Usage](#usage)",
    "- [Removed](#removed)",
    "",
    "## Install",
    "## Usage",
    "",
  ].join("\n");

  test("entries pointing at absent headings are one finding listing all of them", () => {
    const b = bundleOf({ "a.md": doc });
    const findings = structureFindings(b).findings.filter((f) => f.title.includes("contents"));
    expect(findings).toHaveLength(1);
    expect(findings[0].summary).toMatch(/#removed/);
    expect(findings[0].sides).toHaveLength(1);
  });

  test("a complete contents list produces nothing", () => {
    const b = bundleOf({ "a.md": "# G\n\n- [Install](#install)\n- [Usage](#usage)\n\n## Install\n## Usage\n" });
    expect(structureFindings(b).findings).toHaveLength(0);
  });

  test("a list of two ordinary links is not mistaken for a contents list", () => {
    const b = bundleOf({ "a.md": "# G\n\n## Install\n\n- see [Install](#install)\n- and [Install](#install) again\n" });
    expect(structureFindings(b).findings).toHaveLength(0);
  });

  test("tocEntries picks the longest run of anchor list items", () => {
    const b = bundleOf({ "a.md": doc });
    const entries = tocEntries(b.docs[0]);
    expect(entries.map((e) => e.anchor)).toEqual(["install", "usage", "removed"]);
  });

  test("a numbered contents list is recognized too", () => {
    const b = bundleOf({ "a.md": "# G\n\n1. [Install](#install)\n2. [Gone](#gone)\n\n## Install\n" });
    const findings = structureFindings(b).findings.filter((f) => f.title.includes("contents"));
    expect(findings).toHaveLength(1);
  });
});

describe("history and example sections stay in scope for structure", () => {
  // Structure deliberately reads these regions: their headings are real
  // headings that belong in a contents list, and their links really can dangle.
  test("a dangling anchor inside a changelog is still a dangling anchor", () => {
    const b = bundleOf({ "a.md": "# Doc\n\n## Changelog\n\nSee [x](#gone).\n" });
    expect(structureFindings(b).findings).toHaveLength(1);
  });

  test("a duplicate heading between a live section and a changelog still collides", () => {
    const b = bundleOf({ "a.md": "## Options\ntext\n## Changelog\n### Options\ntext\n" });
    const dupes = structureFindings(b).findings.filter((f) => f.title.includes("Duplicate"));
    expect(dupes).toHaveLength(1);
  });
});

describe("clean documents", () => {
  test("a well-formed set produces no findings and no unverifiable refs", () => {
    const b = bundleOf({
      "a.md": "# Guide\n\n- [Install](#install)\n- [Usage](#usage)\n\n## Install\n\nSee [more](b.md#detail).\n\n## Usage\n\ntext\n",
      "b.md": "# Reference\n\n## Detail\n\ntext\n",
    });
    const { findings, unverifiableRefs } = structureFindings(b);
    expect(findings).toEqual([]);
    expect(unverifiableRefs).toEqual([]);
  });
});
